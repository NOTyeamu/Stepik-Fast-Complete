using System;

class Program
{
    static void Main()
    {
        string[] dateParts = Console.ReadLine().Split(' ');
        Console.WriteLine($"{dateParts[2]}.{dateParts[1]}.{dateParts[0]}");
    }
}