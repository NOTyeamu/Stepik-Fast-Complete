using System;

class Program
{
    static void Main()
    {
        string email = Console.ReadLine();
        string[] parts = email.Split('@');
        Console.WriteLine("Логин: " + parts[0]);
        Console.WriteLine("Домен: " + parts[1]);
    }
}