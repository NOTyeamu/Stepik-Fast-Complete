using System;

class Program
{
    static void Main()
    {
        int number = int.Parse(Console.ReadLine());
        int firstDigit = number / 10;
        int secondDigit = number % 10;
        Console.WriteLine(firstDigit + secondDigit);
    }
}