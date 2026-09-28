using System;

class Program
{
    static void Main()
    {
        string password = Console.ReadLine();
        if (password == "1234")
        {
            Console.WriteLine("Пароль принят");
        }
        else
        {
            Console.WriteLine("Неверный пароль");
        }
    }
}